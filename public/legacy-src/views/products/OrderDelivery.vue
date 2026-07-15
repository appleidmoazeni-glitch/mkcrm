<template>
  <main class="main-content">
    <div class="card overflow-hidden">
      <div class="page-header page-header-cover p-t-b-40" data-backround-image="/admin/assets/media/image/image1.png">
        <div class="container">
          <div class="row d-flex justify-content-center">
            <div class="col-md-6">
              <h2 class="mb-4 text-white text-center">فرم تحویل کالا</h2>
              <div class="input-group mb-3">

                <input v-model="orderId" @keypress.enter="getOrderItems(orderId)" type="text" class="form-control" aria-label="Example text with button addon" placeholder="شناسه کالا را وارد نمایید ..." aria-describedby="button-addon1">
                <div class="input-group-append">
                  <button @click="getOrderItems(orderId)" class="btn btn-primary" type="button" id="button-addon1"><i class="ti-search"></i></button>
                </div>

              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-if="step!='none'" class="card-body">
        <div v-if="step=='loading'" class="text-center text-muted">
          <i class="fa fa-4x fa-refresh fa-spin"></i>
        </div>
        <template v-else>

          <h4 class="mb-4 primary-font">
            <i class="fa fa-search m-l-10"></i>سفارش {{ orderInfo.CustomOrderNumber }}
            <div class="d-inline-flex">
              <small class="text-muted">«ثبت شده در تاریخ {{ orderInfo.CreatedOnUtc ? new Date(orderInfo.CreatedOnUtc).echoFa("Y/m/d") : "" }}»</small>
              <b-button class="btn-lg p-0 mr-2" data-toggle="modal" data-index="0" data-target="#setComment" variant="link" v-b-popover.hover.right="orderInfo['AdminComment'] || ''"><i :class="['fa fa-info-circle is-big ml-2', (orderInfo['AdminComment'] || '') ? 'text-danger' : 'text-muted']"></i></b-button>
            </div>
          </h4>

          <ul class="nav nav-tabs m-b-30" id="myTab" role="tablist">
            <li class="nav-item"><a class="nav-link active" data-toggle="tab" href="#info" role="tab" aria-controls="info" aria-selected="true">اطلاعات مشتری</a></li>
            <li class="nav-item"><a class="nav-link" data-toggle="tab" href="#items" role="tab" aria-controls="items" aria-selected="false">کالا های خریداری شده</a></li>
            <li class="nav-item"><a class="nav-link" data-toggle="tab" href="#delivery" role="tab" aria-controls="delivery" aria-selected="false">تحویل</a></li>
          </ul>
          <div class="tab-content" id="myTabContent">
            <div class="tab-pane fade show active m-t-20-minus" id="info" role="tabpanel">
              <div class="row customer-info">
                <div class="form-group col-lg-6">
                  <small class="text-muted">تحویل گیرنده:</small>
                  <h5 class="form-text m-t-10-minus">{{ orderInfo.FirstName }} {{ orderInfo.LastName }}</h5>
                </div>
                <div class="form-group col-lg-6">
                  <small class="text-muted">شماره تماس تحویل گیرنده:</small>
                  <h5 class="form-text m-t-10-minus">{{ orderInfo.PhoneNumber }}</h5>
                </div>
                <div class="form-group col-lg-6">
                  <small class="text-muted">آدرس تحویل گیرنده:</small>
                  <h5 class="form-text m-t-10-minus">{{ orderInfo.Address1 }}</h5>
                </div>
                <div class="form-group col-lg-6">
                  <small class="text-muted">تعداد مرسوله:</small>
                  <h5 class="form-text m-t-10-minus">{{ orderItemsCount }} مرسوله</h5>
                </div>
                <div class="form-group col-lg-6">
                  <small class="text-muted">زمان ارسال:</small>
                  <h5 class="form-text m-t-10-minus">{{ orderInfo.DeliveryDate ? new Date(orderInfo.DeliveryDate).echoFa("Y/m/d") : '-' }}</h5>
                </div>
                <div class="form-group col-lg-6">
                  <small class="text-muted">نحوه ارسال:</small>
                  <h5 class="form-text m-t-10-minus">{{ orderInfo.ShippingMethod }}</h5>
                </div>
                <div class="form-group col-lg-6">
                  <small class="text-muted">وضعیت سفارش:</small>
                  <h5 class="form-text m-t-10-minus"><i :class="['fa is-big', orderStatusTitle(orderInfo.OrderStatusId).icon]"></i> {{ orderStatusTitle(orderInfo.OrderStatusId).title }}</h5>
                </div>
                <div class="form-group col-lg-6">
                  <small class="text-muted">روش پرداخت:</small>
                  <h5 class="form-text m-t-10-minus"><img :src="getBankInfo(orderInfo.Gateway).img" width="20"> {{ getBankInfo(orderInfo.Gateway).title }}</h5>
                </div>
                <div class="form-group col-lg-6">
                  <small class="text-muted">مبلغ کل:</small>
                  <h5 class="form-text m-t-10-minus">{{ orderInfo.OrderTotal ? number_format(orderInfo.OrderTotal) : 0 }} تومان</h5>
                </div>
                <div class="form-group col-lg-6">
                  <small class="text-muted">وضعیت پرداخت:</small>
                  <h5 class="form-text m-t-10-minus">{{ orderInfo.PaymentStatusId == 30 ? "پرداخت شده" : "در انتظار" }}</h5>
                </div>
              </div>
            </div>
            <div class="tab-pane fade" id="items" role="tabpanel">
              <div class="row">
                <div v-for="item of orderItems" class="col-lg-6 col-md-12">
                  <div class="card border">
                    <div class="d-flex p-0 card-body">
                      <img class="card-img-right" :src="'https://mashadkala.com/images/thumbs/' + item.filename + '_75.' + getFileFormat(item.MimeType)" alt="image">
                      <div class="p-2 pl-3 card-text w-100">
                        <div class="p-descr">
                          <h6 dir="ltr">{{item.Name}}</h6>
                          <p class="text-muted small-descr" v-html="item.AttributeDescription"></p>
                          <small v-if="item.Gtin">Gtin: {{item.Gtin}}</small>
                        </div>
                        <div class="footer-items">
                          <span class="badge badge-secondary">{{number_format(item.UnitPriceExclTax)}} تومان</span>
                          <span v-if="item.Quantity>1" class="badge badge-warning ml-1 b-q">{{item.Quantity}}X</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="tab-pane fade" id="delivery" role="tabpanel">
              <ul class="list-group list-group-flush">
                <li class="list-group-item p-l-r-0">
                  <div class="media align-items-center">
                    <figure class="avatar m-l-15">
                      <span class="avatar-title bg-secondary rounded-circle"><i class="fa fa-unlock text-warning"></i></span>
                    </figure>
                    <div class="media-body">
                      <h5 class="line-height-24 b-q">{{ orderInfo.TrackingNumber }}</h5>
                      <p class="m-b-0 text-muted">کد رهگیری / احراز هویت</p>
                    </div>
                  </div>
                </li>
                <li class="list-group-item p-l-r-0">
                  <div class="media align-items-center">
                    <figure class="avatar m-l-15">
                      <span :class="['avatar-title rounded-circle', shippingStatus(orderInfo.ShippingStatusId).bg]"><i :class="['fa', shippingStatus(orderInfo.ShippingStatusId).icon]"></i></span>
                    </figure>
                    <div class="media-body">
                      <h5 class="primary-font line-height-24">{{ shippingStatus(orderInfo.ShippingStatusId).title }}</h5>
                      <p class="m-b-0 text-muted">وضعیت تحویل کالا</p>
                    </div>
                    <div class="btn-group btn-group-sm" role="group" v-if="orderInfo.OrderStatusId == 30">
                      <button type="button" :disabled="orderInfo.ShippingStatusId == 20" @click="setOrderStatus(orderInfo['OrderId'], 'shipp', 20)" :class="['p-l-r-20 btn btn-lg', orderInfo.ShippingStatusId == 20 ? 'btn-light' : 'btn-outline-light']"><i :class="['fa', shippingStatus(20).icon]"></i></button>
                      <button type="button" :disabled="orderInfo.ShippingStatusId == 30"  @click="setOrderStatus(orderInfo['OrderId'], 'shipp', 30)" :class="['p-l-r-20 btn btn-lg', orderInfo.ShippingStatusId == 30 ? 'btn-light' : 'btn-outline-light']"><i :class="['fa', shippingStatus(30).icon]"></i></button>
                      <button type="button" :disabled="orderInfo.ShippingStatusId == 40" @click="setOrderStatus(orderInfo['OrderId'], 'shipp', 40)" :class="['p-l-r-20 btn btn-lg', orderInfo.ShippingStatusId == 40 ? 'btn-light' : 'btn-outline-light']"><i :class="['fa', shippingStatus(40).icon]"></i></button>
                    </div>
                  </div>
                </li>
              </ul>
            </div>
          </div>

        </template>
      </div>

    </div>
    <modal-comment :ordersList="[{id:orderInfo['OrderId'], AdminComment: orderInfo['AdminComment'] || ''}]" />

  </main>
</template>
<script>
import ModalComment from "../../components/ModalComment";
import util from "../../assets/pureFunctions.js";
import axios from "axios";

export default {
  data(){return {
    step: "none",
    orderId: "",
    orderItems: [],
    orderInfo: {},
    orderItemsCount: 0,
    number_format: util.number_format,
  }},
  methods:{
    getOrderItems(id){
      const vm = this;
      if( id ){
        if( id == '-800' ){

        }else{
          this.step = "loading";
          this.orderId = id;
          this.orderItems = [];
          this.orderInfo = {};
          let step = 0;
          axios.get('/admin/delivery/orderDelivery/getOrderItems', {params:{id}}).then(({data}) => {
            if( data.ok ){
              this.orderItems = data.list;
              this.orderItemsCount = 0;
              for(let i of data.list){
                this.orderItemsCount += i.Quantity;
              }
              if( ++step == 2 ) this.step = "done";
            }else{
              toastr['error'](data.error);
              this.orderId = '';
              this.step = "none";
            }
          });
          axios.get('/admin/delivery/orderDelivery/getOrderInfo', {params:{id}}).then(({data}) => {
            if( data.ok ){
              this.orderInfo = data.info;
              if( ++step == 2 ) this.step = "done";
            }else{
              toastr['error'](data.error);
              this.orderId = '';
              this.step = "none";
            }
          });
        }
      }
    },
    async setOrderStatus(id, type, value){
      const {data} = await axios.put('/admin/products/ordersList', {id, type, value});
      if( type == "order" ){
        if( data.ok ) this.orderInfo.OrderStatusId = value;
        else toastr['error'](data.error);
      }
      if( type == "shipp" ){
        if( data.ok ){
          this.orderInfo.ShippingStatusId = value;
          if( !isNaN(data.trackingnumber) ) this.orderInfo.trackingnumber = data.trackingnumber;
        }else toastr['error'](data.error);
      }
    },
    getFileFormat(mimeType){
      let parts = mimeType.split('/');
      let lastPart = parts[parts.length - 1];
      switch (lastPart)
      {
        case "jpeg":
          lastPart = "jpeg";
          break;
        case "x-png":
          lastPart = "png";
          break;
        case "x-icon":
          lastPart = "ico";
          break;
      }
      return lastPart;
    },
    orderStatusTitle(id){
      switch (id){
        case 10: return {title: "انتظار", icon: "fa-money"};
        case 20: return {title: "پردازش", icon: "fa-spinner text-muted"};
        case 30: return {title: "تکمیل", icon: "fa-check text-success"};
        case 40: return {title: "لغو", icon: "fa-times text-danger"};
        default: return {title: "-", icon: ""};
      }
    },
    shippingStatus(id){
      switch (id){
        case 20: return {title: "حمل نشده", icon: "fa-ban text-danger", bg: "bg-light"};
        case 30: return {title: "ارسال شده", icon: "fa-truck text-warning", bg: "bg-success-bright"};
        case 40: return {title: "تحویل شده", icon: "fa-check text-success", bg: "bg-success"};
        default: return {title: "?", icon: "fa-question text-muted", bg: "bg-light"};
      }
    },
    getBankInfo(name){
      switch (name){
        case "Payments.Saman": return {title: "درگاه بانک سامان", img: "/admin/assets/media/image/bank-saman.png"};
        case "Payments.Mellat": return {title: "درگاه بانک ملت", img: "/admin/assets/media/image/bank-mellat.png"};
        case "Payments.AsanPardakht": return {title: "درگاه آسان پرداخت", img: "/admin/assets/media/image/bank-up.png"};
        default: return {title: "", img: ""};
      }
    }
  },
  mounted() {
    if( this.$route.params.id ){
      this.orderId = this.$route.params.id;
      this.getOrderItems(this.orderId);
    }
  },
  components: {
    'modal-comment': ModalComment
  }
}
</script>
<style scoped>
.card-img-right{width: 100px; height: 100px; margin-left: 5px;}
.small-descr{font-size: 11px;line-height: 16px;margin-bottom: 0;}
.b-q{font-family: Arial; font-weight: bold;}
.p-descr{
  margin-bottom: 1.5rem;
  min-height: 110px;
}
.footer-items{
  display: flex;
  flex-direction: row-reverse;
  position: absolute;
  bottom: 5px;
  left: 10px;
}
.customer-info .form-group{margin-bottom: 0; padding-bottom: 10px;border-bottom: 1px solid rgba(0,0,0,.125)}
.customer-info .form-group:nth-child(odd){
  border-left: 1px solid rgba(0,0,0,.125);
}
.customer-info .form-group:nth-last-child(1),
.customer-info .form-group:nth-last-child(2){border-bottom: none;}
.bg-success .text-success{color: #FFF !important;}
main.main-content {
  min-height: 500px;
}
.fa-large{
  font-size: 20px;
  cursor: pointer;
}
</style>
